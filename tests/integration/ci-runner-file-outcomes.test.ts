import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isOpenShellInstallerFile } from "../../scripts/ci/openshell-full-integration.ts";
import { projectFailureDiagnostic } from "../../scripts/ci/reporter-diagnostics.ts";
import { nativeFirstAgentProofDiagnostic } from "../../scripts/ci/reporter.ts";
import {
  readFileEvidence,
  splitCaseFailure,
  type FileEvidence,
} from "../../scripts/ci/runner-reporter-output.ts";
import {
  createRunnerFixture,
  laneArgs,
  runnerEnv,
  runRunnerAsync,
  runRunnerSync,
  writeCleanupFixture,
  writeRunnerManifest,
  writeSingleFileRunnerLane,
} from "../helpers/ci-runner-fixture.ts";

const runnerPath = fileURLToPath(new URL("../../scripts/ci/run-tests.ts", import.meta.url));
const progressUrl = new URL("../../scripts/ci/openshell-progress.mjs", import.meta.url);

interface RunSummary {
  status: string;
  exitCode: number;
  counts: { passed: number; failed: number; skipped: number; todo: number; total: number };
  issues: { code: string }[];
  files: {
    path: string;
    status: string;
    nodeExitCode: number;
    measurements?: unknown[];
    installationPhases?: {
      truncated: boolean;
      phases: {
        invocation: number;
        stage: string;
        outcome: string;
        enteredMs: number;
        elapsedMs?: number;
      }[];
    };
    cleanup: { status: string };
    fileFailure?: unknown;
    tests: { name: string; status: string; error?: { message?: string; diagnostic?: unknown } }[];
  }[];
}

async function readSummary(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as RunSummary;
}

function onlyFile(summary: RunSummary) {
  const [file] = summary.files;
  assert.ok(file && summary.files.length === 1, "expected one file result");
  return file;
}

async function checkUpstreamInstallationPhases(root: string) {
  const file = "tests/integration/openshell-upstream-real.test.ts";
  const title = "OpenShell model and tool upstream outages fail closed";
  const repositoryUrl = new URL("../../", import.meta.url);
  const sibling = "tests/integration/local-first-agent-openshell-real.test.mjs";
  const installationModule = new URL("tests/helpers/openshell-installation.ts", repositoryUrl).href;
  const stageModule = new URL("tests/helpers/openshell-stage.ts", repositoryUrl).href;
  const privateValue = "/fixture/installation-phase-value";
  const failure = "synthetic gateway Helm failure";
  const child = `import assert from "node:assert/strict";
import test from "node:test";
import { runGatewayInstallation } from ${JSON.stringify(installationModule)};
import { runOpenShellStage } from ${JSON.stringify(stageModule)};
test(${JSON.stringify(title)}, async (t) => {
  const failure = new Error(${JSON.stringify(failure)});
  await runOpenShellStage(t, "installation", async () => {
    try {
      await runGatewayInstallation(
        async () => {},
        async () => ${JSON.stringify(privateValue)},
        async (value) => {
          assert.equal(value, ${JSON.stringify(privateValue)});
          throw failure;
        },
        async () => assert.fail("readiness must not run after failed Helm"),
      );
    } catch (error) {
      assert.equal(error, failure);
      throw error;
    }
  });
});`;

  await writeCleanupFixture(root);
  // Run the real phase producer in the same test runner with harmless installation operations.
  for (const [lane, files, recordedFile] of [
    ["openshell", [sibling], sibling],
    ["openshell-policy", [sibling], sibling],
    ["progress", [file], undefined],
    ["openshell-installers", [sibling, file], file],
  ] as const) {
    const state = `state/${lane}-installation.jsonl`;
    const results = join(root, `results/${lane}-installation.json`);
    for (const path of files) {
      await writeFile(join(root, path), child);
    }
    await writeRunnerManifest(root, {
      lanes: { [lane]: { files: files.map((path) => ({ path, expectedTests: [title] })) } },
    });
    const result = await runRunnerAsync(laneArgs(root, lane, state, results));
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.signal, null);
    const cleaned = await readFile(join(root, state), "utf8");
    assert.deepEqual(cleaned.trimEnd().split("\n").sort(), [...files].sort());
    const artifact = await readFile(results, "utf8");
    const summary = JSON.parse(artifact) as RunSummary;
    assert.equal(summary.exitCode, result.status);
    assert.deepEqual(summary.files.map(({ path }) => path).sort(), [...files].sort());
    for (const text of [artifact, result.stdout, result.stderr]) {
      assert.equal(text.includes(privateValue), false);
    }
    for (const entry of summary.files) {
      assert.equal(entry.nodeExitCode, 1);
      assert.deepEqual(entry.cleanup, { status: "passed" });
      assert.deepEqual(
        entry.tests.map(({ name, status, error }) => [name, status, error?.message]),
        [[title, "failed", failure]],
      );
      if (entry.path !== recordedFile) {
        assert.equal(Object.hasOwn(entry, "installationPhases"), false, `${lane}: ${entry.path}`);
        continue;
      }
      const progress = entry.installationPhases;
      assert.ok(progress, `${lane}: ${entry.path} omitted installationPhases`);
      assert.equal(progress.truncated, false);
      const phases = progress.phases.map(({ enteredMs, elapsedMs, ...phase }) => {
        assert.ok(Number.isSafeInteger(enteredMs) && enteredMs >= 0);
        assert.ok(elapsedMs !== undefined && Number.isSafeInteger(elapsedMs) && elapsedMs >= 0);
        return phase;
      });
      assert.deepEqual(phases, [
        { invocation: 1, stage: "workspace-helm", outcome: "passed" },
        { invocation: 1, stage: "gateway-helm", outcome: "failed" },
      ]);
    }
  }
}

test("run preserves nonzero child Node exits and rejects zero-case files", async (t) => {
  const root = await createRunnerFixture(t);
  await writeRunnerManifest(root, {
    lanes: {
      exits: {
        files: [{ path: "tests/integration/exits.test.mjs" }],
      },
      empty: {
        files: [{ path: "tests/integration/empty.test.mjs" }],
      },
    },
  });
  await writeFile(join(root, "tests/integration/exits.test.mjs"), "process.exit(42);\n");
  await writeFile(join(root, "tests/integration/empty.test.mjs"), "process.exit(0);\n");

  const exits = runRunnerSync(laneArgs(root, "exits", "state/exits.jsonl", "results/exits.json"));
  assert.ifError(exits.error);
  assert.equal(exits.signal, null);
  assert.notEqual(exits.status, 0);
  const exitSummary = await readSummary(join(root, "results/exits.json"));
  assert.equal(onlyFile(exitSummary).nodeExitCode, exits.status);
  assert.equal(exitSummary.exitCode, exits.status);

  const empty = runRunnerSync(laneArgs(root, "empty", "state/empty.jsonl", "results/empty.json"));
  assert.equal(empty.status, 1);
  const emptySummary = await readSummary(join(root, "results/empty.json"));
  assert.deepEqual(
    emptySummary.issues.map((entry) => entry.code),
    ["selected-zero"],
  );

  await checkUpstreamInstallationPhases(root);
});

test(
  "run annotates the first failed file before the lane finishes",
  { timeout: 30_000 },
  async (t) => {
    const root = await createRunnerFixture(t);
    const first = "first.test.mjs";
    const second = "second.test.mjs";
    const files = [first, second].map((path) => ({ path }));
    const state = "state/lane.jsonl";
    const resultsPath = join(root, "results/sample.json");
    await writeCleanupFixture(root);
    await writeRunnerManifest(root, {
      lanes: { sample: { files, fileConcurrency: 2, parallelFiles: [first, second] } },
      groups: {},
    });
    const failingCase = `import test from "node:test";
test("private-case-canary", () => {
  throw Object.assign(new Error("::warning::private-message-canary"), {
    openclawCiDiagnostic: { kind: "openshell-credential-replacement", stage: "replacement" },
  });
});`;
    const passingCase = 'import test from "node:test";\ntest("passing case", () => {});\n';
    await writeFile(join(root, second), failingCase);
    // Hold manifest file 1 open so file 2 fails first and reports while the lane is live.
    const release = join(root, "release");
    await writeFile(
      join(root, first),
      `import { existsSync } from "node:fs";
     import { setTimeout } from "node:timers/promises";
     import test from "node:test";
     test("later failure", {timeout: 20000}, async () => {
       while (!existsSync(${JSON.stringify(release)})) await setTimeout(50);
       throw new Error("later failure");
     });\n`,
    );
    const args = laneArgs(root, "sample", state, resultsPath);
    const env = {
      GITHUB_ACTIONS: "true",
      CI_RUNNER_FILE_CONCURRENCY: "2",
      OCC_CI_SUITE_VIEW: "default",
    };
    const child = spawn(process.execPath, [runnerPath, ...args], {
      env: runnerEnv(env),
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject).once("close", resolve);
    });
    const failureCommand =
      "::error title=Test lane failure::A test file reported failed tests and its cleanup passed. Final lane results will follow.";
    const ordinalHint =
      "::notice title=Test lane first failed file hint::Original manifest file ordinal";
    const commands = (output: string) => output.match(/^::[^\n]*(?=\n)/gm) ?? [];
    const firstFailureCommands = [failureCommand, `${ordinalHint} 2.`];
    let code: number | null;
    try {
      const deadline = Date.now() + 10_000;
      while (commands(stderr).length < firstFailureCommands.length && Date.now() < deadline) {
        await setTimeout(50);
      }
      assert.equal(commands(stderr)[0], failureCommand);
      // This is file 2's cleanup, while the lane and its later cleanup are still pending.
      assert.equal(await readFile(join(root, state), "utf8"), `${second}\n`);
      assert.equal(child.exitCode, null);
      assert.equal(existsSync(resultsPath), false);
      assert.deepEqual(commands(stderr), firstFailureCommands);
    } finally {
      await writeFile(release, "");
      code = await closed;
    }
    assert.equal(code, 1);
    // Match entire commands to exclude child-controlled text and repeated hints.
    assert.deepEqual(commands(stderr), firstFailureCommands);
    assert.equal(await readFile(join(root, state), "utf8"), `${second}\n${first}\n`);
    const result = await readSummary(resultsPath);
    assert.equal(result.counts.failed, 2);

    const focused = await runRunnerAsync(
      [
        ...laneArgs(root, "sample", "state/focused.jsonl", "results/focused.json"),
        "--file",
        second,
      ],
      env,
    );
    assert.ifError(focused.error);
    assert.equal(focused.status, 1);
    assert.deepEqual(commands(focused.stderr), [failureCommand, `${ordinalHint} UNKNOWN.`]);

    await writeFile(join(root, second), passingCase);
    const green = await runRunnerAsync(
      [...laneArgs(root, "sample", "state/green.jsonl", "results/green.json"), "--file", second],
      env,
    );
    assert.ifError(green.error);
    assert.equal(green.status, 0, green.stderr);
    assert.deepEqual(commands(green.stderr), []);

    // The first policy file follows all five installers in the original manifest.
    const canonical = JSON.parse(
      await readFile(
        new URL("../../scripts/ci/test-suites/openshell.json", import.meta.url),
        "utf8",
      ),
    ) as { files: { path: string; expectedTests?: string[] }[] };
    const installerFailure = canonical.files.find(
      ({ path }) => path === "tests/integration/local-first-agent-openshell-real.test.mjs",
    );
    assert.ok(installerFailure?.expectedTests);
    const [parentCase, nativeCase] = installerFailure.expectedTests;
    assert.ok(parentCase && nativeCase);
    const credentialsFailure = canonical.files.find(
      ({ path }) => path === "tests/integration/openshell-credentials-real.test.ts",
    );
    const credentialsCase = credentialsFailure?.expectedTests?.[0];
    assert.ok(credentialsFailure && credentialsCase);
    const credentialsPath = credentialsFailure.path;
    const policyDeclaration = join(root, "tests/helpers/openshell-sandbox-workflows.mjs");
    const stageModule = new URL("../helpers/openshell-stage.ts", import.meta.url).href;
    await mkdir(join(root, "tests/helpers"));
    await writeFile(
      join(root, credentialsPath),
      'await import("../helpers/openshell-sandbox-workflows.mjs");\n',
    );
    const policyImports = `import test from "node:test";
import { runOpenShellStage } from ${JSON.stringify(stageModule)};
`;
    const policyFailure = `test(${JSON.stringify(credentialsCase)}, async (context) => {
  await runOpenShellStage(context, "exposure-auth", () => {
    throw new Error("::warning::private-credentials-case");
  });
});\n`;
    await writeFile(policyDeclaration, policyImports + policyFailure);
    const installers = canonical.files
      .filter(({ path }) => isOpenShellInstallerFile(path))
      .map((file) =>
        file === installerFailure
          ? { path: file.path, expectedTests: file.expectedTests }
          : { path: file.path },
      );
    await writeRunnerManifest(root, {
      lanes: {
        openshell: {
          files: [...installers, { path: credentialsPath, expectedTests: [credentialsCase] }],
        },
      },
      groups: { full: ["openshell"] },
    });
    const splitEnv = { ...env, OCC_CI_SUITE_VIEW: "full-integration" };
    const splitHint =
      "::notice title=Test lane first failed split file hint::Split-lane file position";
    const unknownOrdinalCommands = [failureCommand, `${ordinalHint} UNKNOWN.`];
    const policyRun = (label: string, ...args: string[]) =>
      runRunnerAsync(
        [
          ...laneArgs(root, "openshell-policy", `state/${label}.jsonl`, `results/${label}.json`),
          ...args,
        ],
        splitEnv,
      );
    const split = await policyRun("split");
    assert.ifError(split.error);
    assert.equal(split.status, 1, split.stderr);
    const splitSummary = await readSummary(join(root, "results/split.json"));
    assert.equal(splitSummary.counts.failed, 1);
    const failedPolicy = onlyFile(splitSummary);
    assert.equal(failedPolicy.path, credentialsPath);
    assert.equal(failedPolicy.cleanup.status, "passed");
    assert.deepEqual(commands(split.stderr), [
      ...unknownOrdinalCommands,
      `${splitHint} 1.`,
      "::notice title=OpenShell credential replacement failure::The registered credential replacement case reported a failure at stage exposure-auth.",
    ]);

    // Even selecting the only policy file explicitly is a focused run.
    const focusedSplit = await policyRun("split-focused", "--file", credentialsPath);
    assert.ifError(focusedSplit.error);
    assert.equal(focusedSplit.status, 1, focusedSplit.stderr);
    assert.deepEqual(commands(focusedSplit.stderr), unknownOrdinalCommands);

    // Only the named case may supply the failed stage, and it must occur once.
    const sibling = `test("withdrawal fixture", () => {
  throw Object.assign(new Error("::warning::private-sibling"), {
    openclawCiDiagnostic: { kind: "openshell-credential-replacement", stage: "replacement" },
  });
});`;
    const unclassified = `test(${JSON.stringify(credentialsCase)}, () => { throw new Error("unclassified"); });`;
    for (const [label, cases] of [
      ["sibling", unclassified + sibling],
      ["duplicate", policyFailure + policyFailure],
    ] as const) {
      await writeFile(policyDeclaration, policyImports + cases);
      const denied = await policyRun(label);
      assert.ifError(denied.error);
      assert.equal(denied.status, 1, denied.stderr);
      assert.deepEqual(
        commands(denied.stderr),
        [...unknownOrdinalCommands, `${splitHint} 1.`],
        label,
      );
    }
    // Malformed or unapproved values must not even reach the runner's case record.
    const kind = "openshell-credential-replacement";
    const project = (stage: unknown) =>
      projectFailureDiagnostic(
        { openclawCiDiagnostic: { kind, stage } },
        nativeFirstAgentProofDiagnostic,
      );
    assert.deepEqual(project("replacement"), { kind, stage: "replacement" });
    for (const stage of [
      undefined,
      "non-model-source",
      "credential-absence",
      "replacement\n::warning::private-stage",
    ]) {
      assert.equal(project(stage), undefined);
    }

    for (const { path } of installers) {
      await writeFile(join(root, path), passingCase);
    }
    // The wrapper imports the declaration just as the Compose installer does, so
    // Node reports the actual declaration as the nested terminal's source.
    await writeFile(
      join(root, installerFailure.path),
      'await import("./local-first-agent-real.test.mjs");\n',
    );
    const nativeDeclaration = join(root, "tests/integration/local-first-agent-real.test.mjs");
    const proofModule = new URL("../helpers/local-first-agent-native.mjs", import.meta.url).href;
    const controller = join(root, "controller-proof");
    await writeFile(
      controller,
      `#!${process.execPath}
process.stdout.write('OCE_NATIVE_FIRST_AGENT_PROOF {"verified":false,"stage":"model-outcome","modelPhase":"initial","detail":"private-controller-proof"}\\n');
process.exitCode = 1;
`,
      { mode: 0o700 },
    );
    await writeFile(
      nativeDeclaration,
      `
import test from "node:test";
import { assertNativeWorkerProofInController } from ${JSON.stringify(proofModule)};
function reportFailure(failureStage) {
  throw Object.assign(new Error("::warning::private-proof-canary"), {
    openclawCiDiagnostic: { kind: "native-first-agent-proof", failureStage },
  });
}
test(${JSON.stringify(parentCase)}, async (t) => {
  const options = {
    stateDirectory: ${JSON.stringify(root)},
    state: {
      containerEngine: ${JSON.stringify(controller)},
      repository: ${JSON.stringify(root)},
      composeProject: "test-only",
    },
    environment: {},
  };
  await t.test("different proof stage", () => reportFailure("exec-proof"));
  await t.test("initial proof sibling", (context) =>
    assertNativeWorkerProofInController(context, options));
  await t.test(${JSON.stringify(nativeCase)}, (context) =>
    assertNativeWorkerProofInController(context, {
      ...options,
      session: { key: "private-session-key", sessionId: "private-session-id" },
    }),
  );
});`,
    );
    const installerResults = join(root, "results/split-installers.json");
    const installerSplit = await runRunnerAsync(
      laneArgs(root, "openshell-installers", "state/split-installers.jsonl", installerResults),
      splitEnv,
    );
    assert.ifError(installerSplit.error);
    assert.equal(installerSplit.status, 1, installerSplit.stderr);
    const installerSummary = await readSummary(installerResults);
    assert.equal(installerSummary.exitCode, 1);
    assert.deepEqual(
      installerSummary.files.map(({ path, status }) => [path, status]),
      installers.map(({ path }) => [path, path === installerFailure.path ? "failed" : "passed"]),
    );
    const installerOutcome = installerSummary.files.find(
      ({ path }) => path === installerFailure.path,
    );
    assert.ok(installerOutcome);
    assert.equal(installerOutcome.nodeExitCode, 1);
    assert.deepEqual(installerOutcome.cleanup, { status: "passed" });
    assert.deepEqual(commands(installerSplit.stderr), [
      ...unknownOrdinalCommands,
      `${splitHint} 2.`,
      "::notice title=Native first-Agent proof failure::The registered native redeployment case reported a failure at proof stage model-outcome.",
      "::notice title=Native first-Agent model-outcome phase::The registered native redeployment case reported a model-outcome failure during its resumed proof.",
    ]);
    const modelOutcome = { kind: "native-first-agent-proof", failureStage: "model-outcome" };
    assert.deepEqual(
      installerOutcome.tests.map(({ name, status, error }) => [name, status, error?.diagnostic]),
      [
        [
          "different proof stage",
          "failed",
          { kind: "native-first-agent-proof", failureStage: "exec-proof" },
        ],
        ["initial proof sibling", "failed", { ...modelOutcome, modelPhase: "initial" }],
        [nativeCase, "failed", { ...modelOutcome, modelPhase: "resumed" }],
        [parentCase, "failed", undefined],
      ],
    );

    // Feed the runner's real evidence reader terminal events. Keep the siblings
    // first to detect attribution to a sibling when the named case has no usable diagnostic.
    const failure = (name: string, diagnostic: unknown) => ({
      type: "test:fail",
      data: {
        file: nativeDeclaration,
        line: 1,
        name,
        nesting: 1,
        testType: "test",
        error: { location: {}, diagnostic },
      },
    });
    const siblings = [
      failure("different proof stage", { ...modelOutcome, failureStage: "exec-proof" }),
      failure("initial proof sibling", { ...modelOutcome, modelPhase: "initial" }),
    ];
    const selected = (
      diagnostic: unknown,
      relativePath = installerFailure.path,
      interrupted = false,
    ) => {
      const events = [...siblings, failure(nativeCase, diagnostic)];
      const stdout = [
        ...events.map((event) => JSON.stringify(event)),
        ...(interrupted ? [JSON.stringify({ type: "test:interrupted", data: {} })] : []),
      ].join("\n");
      const evidence: FileEvidence = {
        measurements: [],
        testRunExercised: false,
        tests: [],
        skippedSuites: [],
      };
      readFileEvidence(
        { stdout, status: 1, signal: null },
        {
          root,
          absolutePath: join(root, relativePath),
          relativePath,
          laneName: "openshell-installers",
          expectedTests: [nativeCase],
          env,
          focused: false,
        },
        evidence,
        [],
      );
      return evidence[splitCaseFailure];
    };
    const resumed = { ...modelOutcome, modelPhase: "resumed" };
    const initial = { ...modelOutcome, modelPhase: "initial" };
    assert.deepEqual(selected(initial), initial);
    assert.deepEqual(
      selected(resumed, "tests/integration/local-first-agent-openshell-k3d-real.test.mjs"),
      modelOutcome,
    );
    assert.equal(selected(resumed, installerFailure.path, true), undefined);
    assert.equal(selected(undefined), undefined);
    assert.equal(
      selected({ ...modelOutcome, failureStage: "private\n::warning::stage" }),
      undefined,
    );
    for (const modelPhase of [undefined, "resumed\n::warning::private-phase-canary"]) {
      assert.deepEqual(selected({ ...modelOutcome, modelPhase }), modelOutcome);
    }

    await writeFile(
      policyDeclaration,
      `import test from "node:test";\ntest(${JSON.stringify(credentialsCase)}, () => {});\n`,
    );
    const greenSplit = await policyRun("split-green");
    assert.ifError(greenSplit.error);
    assert.equal(greenSplit.status, 0, greenSplit.stderr);
    assert.deepEqual(commands(greenSplit.stderr), []);
  },
);

test("run finishes file accounting and cleanup after a reporter pipe read error", async (t) => {
  const root = await createRunnerFixture(t);
  await writeCleanupFixture(root);
  const file = "tests/integration/pipe.test.mjs";
  const state = join(root, "state/pipe.jsonl");
  const resultPath = join(root, "results/pipe.json");
  await writeRunnerManifest(root, { lanes: { pipe: { files: [{ path: file }] } }, groups: {} });
  const injected = join(root, "injected");
  // Hold the real child until its reporter pipe closes so the fault precedes completion.
  await writeFile(
    join(root, file),
    `import test from "node:test";
import { watch } from "node:fs";
import { emitOpenShellProgress } from ${JSON.stringify(progressUrl.href)};
test("case", async () => {
  const released = new Promise((resolve) => {
    const watcher = watch(${JSON.stringify(root)}, (_event, name) => {
      if (name === "injected") { watcher.close(); resolve(); }
    });
  });
  emitOpenShellProgress("installation", "started");
  await released;
});
`,
  );
  const preload = join(root, "pipe-error.mjs");
  // Fault the real child pipe; spawning, reporting, result accounting and cleanup stay real.
  await writeFile(
    preload,
    `import cp from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const spawn = cp.spawn;
cp.spawn = (...args) => {
  const child = spawn(...args);
  if (args[1]?.includes("--test-reporter")) {
    child.stdout.once("data", () => {
      child.stdout.once("close", () => writeFileSync(${JSON.stringify(injected)}, "faulted"));
      child.stdout.destroy(Object.assign(new Error("private-pipe-canary"), { code: "EIO" }));
    });
  }
  return child;
};
syncBuiltinESMExports();
`,
  );
  const result = await runRunnerAsync(
    laneArgs(root, "pipe", state, resultPath),
    {},
    {
      execArgv: ["--import", preload],
      timeout: 15_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(await readFile(injected, "utf8"), "faulted");
  const artifact = await readFile(resultPath, "utf8");
  const summary = JSON.parse(artifact) as RunSummary;
  const outcome = onlyFile(summary);
  assert.equal(outcome.cleanup.status, "passed");
  assert.equal(await readFile(state, "utf8"), `${file}\n`);
  // The runner preserves native child exit codes, including failures other than 1.
  assert.notEqual(result.status, 0);
  assert.equal(result.status, outcome.nodeExitCode);
  assert.equal(result.status, summary.exitCode);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}\n${artifact}`,
    /private-pipe-canary|Unhandled.*error/,
  );
});

test("run records a sanitized file failure after all reported cases pass", async (t) => {
  const root = await createRunnerFixture(t);
  const resultsPath = join(root, "results/file-failure.json");
  await writeSingleFileRunnerLane(
    root,
    "failure",
    "tests/integration/file-failure.test.mjs",
    [
      'import test from "node:test";',
      'test("first pass", () => {});',
      'setImmediate(() => { throw new Error("secretauthvalue-root-failure"); });',
      'test("second pass", () => {});',
      "",
    ].join("\n"),
  );

  const result = runRunnerSync(laneArgs(root, "failure", "state/file-failure.jsonl", resultsPath));
  const artifact = await readFile(resultsPath, "utf8");
  const summary = JSON.parse(artifact) as RunSummary;
  const file = onlyFile(summary);
  assert.equal(result.status, 1);
  assert.equal(file.status, "failed");
  assert.equal(file.nodeExitCode, result.status);
  assert.equal(summary.counts.passed, 2);
  assert.equal(summary.counts.failed, 0);
  assert.deepEqual(
    file.tests.map(({ name, status }) => [name, status]),
    [
      ["first pass", "passed"],
      ["second pass", "passed"],
    ],
  );
  assert.deepEqual(file.fileFailure, {
    error: {
      code: "ERR_TEST_FAILURE",
      name: "Error",
      failureType: "testCodeFailure",
      exitCode: 1,
      message: "test failed",
    },
    diagnosticKind: "post-test-async-activity",
  });
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${artifact}`, /secretauthvalue/);
});

test("run records failed, skipped, todo, and passed dispositions separately", async (t) => {
  const root = await createRunnerFixture(t);
  const resultsPath = join(root, "results/dispositions.json");

  await writeSingleFileRunnerLane(
    root,
    "dispositions",
    "tests/integration/dispositions.test.mjs",
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("passes", () => assert.equal(1, 1));',
      'test("fails", () => assert.equal(1, 2));',
      'test("skips", { skip: "expected" }, () => {});',
      'test("todo case", { todo: "expected" }, () => {});',
      "",
    ].join("\n"),
  );

  const result = runRunnerSync(
    laneArgs(root, "dispositions", "state/dispositions.jsonl", resultsPath),
  );

  assert.notEqual(result.status, 0);
  const summary = await readSummary(resultsPath);
  assert.equal(summary.status, "failed");
  assert.deepEqual(summary.counts, { passed: 1, failed: 1, skipped: 1, todo: 1, total: 4 });
  assert.deepEqual(
    onlyFile(summary).tests.map((entry) => [entry.name, entry.status]),
    [
      ["passes", "passed"],
      ["fails", "failed"],
      ["skips", "skipped"],
      ["todo case", "todo"],
    ],
  );
});

test("run keeps the enrollment operation pending when the parent is interrupted", async (t) => {
  const root = await createRunnerFixture(t);
  const helper = new URL("../helpers/keycloak-enrollment-wait.ts", import.meta.url);
  const modes = ["body", "cleanup", "untracked", "passed", "rejected", "unavailable"] as const;
  const files = modes.map((mode) => ({ path: `tests/integration/${mode}.test.mjs` }));
  for (const [index, mode] of modes.entries()) {
    const file = files[index];
    assert.ok(file);
    await writeFile(
      join(root, file.path),
      `
        import assert from "node:assert/strict";
        import test from "node:test";
        import { setTimeout as delay } from "node:timers/promises";
        import { writeFileSync } from "node:fs";
        import { enrollmentWait } from ${JSON.stringify(helper.href)};
        test("parent", { timeout: 100 }, async (parent) => {
          const mode = ${JSON.stringify(mode)};
          const wait = enrollmentWait(mode === "unavailable" ? {
            signal: parent.signal, diagnostic() { throw new Error("fixture diagnostic unavailable"); },
          } : parent)(2);
          // Keep Node alive until the real parent timer fires. Settle after cancellation.
          const untilAbort = () => new Promise(resolve => {
            const timer = setTimeout(resolve, 2000);
            parent.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
          await parent.test("row", async (row) => {
            row.after(() => wait("close-context", mode === "cleanup" ? untilAbort() : delay(1)));
            await wait("open-page", (mode === "body" || mode === "unavailable") ? untilAbort() : Promise.resolve());
            if (mode === "untracked") await untilAbort();
            if (mode === "rejected") {
              parent.diagnostic('openclaw-ci-measurement {"kind":"keycloak-enrollment-interrupted","row":2,"operation":"unlisted-input"}');
              parent.diagnostic('openclaw-ci-measurement {"kind":"keycloak-enrollment-interrupted","row":-1,"operation":"open-page"}');
              const original = new Error("synthetic fixture error");
              await assert.rejects(wait("query-users", Promise.reject(original)), e => e === original);
              throw original;
            }
            await wait("wait-for-callback", Promise.resolve());
            if (mode === "body") writeFileSync("late-body-finished", "yes");
          });
        });
      `,
    );
  }
  await writeRunnerManifest(root, { lanes: { enrollment: { files } } });
  const results = "results/enrollment.json";
  const run = runRunnerSync(laneArgs(root, "enrollment", "state/enrollment.jsonl", results));
  assert.ifError(run.error);
  assert.equal(run.status, 1);
  const summary = await readSummary(join(root, results));
  assert.equal(summary.files.length, modes.length);
  assert.equal(await readFile(join(root, "late-body-finished"), "utf8"), "yes");
  for (const [index, mode] of modes.entries()) {
    const file = summary.files[index];
    assert.ok(file);
    assert.equal(file.nodeExitCode, mode === "passed" ? 0 : 1);
    assert.equal(file.tests.length, 2);
    if (mode === "rejected") {
      assert.equal(
        file.tests.find(({ name }) => name === "row")?.error?.message,
        "synthetic fixture error",
      );
    } else if (mode !== "passed") {
      assert.match(
        file.tests.find(({ name }) => name === "parent")?.error?.message ?? "",
        /test timed out after 100ms/,
      );
    }
    assert.deepEqual(
      file.measurements ?? [],
      mode === "body" || mode === "cleanup"
        ? [
            {
              kind: "keycloak-enrollment-interrupted",
              row: 2,
              operation: mode === "body" ? "open-page" : "close-context",
            },
          ]
        : [],
    );
  }
});
